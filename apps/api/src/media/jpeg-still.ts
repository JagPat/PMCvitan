/**
 * #995 V1b — is this upload the still frame a browser draws from a clip (a canvas `toBlob('image/jpeg')`), and nothing
 * else?
 *
 * A bounded marker walk, not a decoder: it reads every segment's header by its type and never decodes the picture.
 * Every marker is read against an allow-list of what a browser's canvas writes; one it does not name is a refusal,
 * never skipped:
 *  - SOI first, then only APP0 (the 14-byte JFIF header with no thumbnail, at most once), APP2 (a single-chunk ICC profile, chunk 1 of 1, at most once),
 *    DQT, DHT, DRI (exactly 4 bytes), exactly one SOF0 or SOF2, and SOS, each segment's length inside the file.
 *  - Each DQT: whole 8-bit tables numbered 0 to 3. Each DHT: whole tables of class DC or AC numbered 0 to 3, each with
 *    1 to 256 codes. Both fill their segment exactly.
 *  - The SOF: 8-bit, 1 or 3 components with distinct ids, sampling factors 1 to 4 and a table 0 to 3, a width and a
 *    height each from 1 to {@link POSTER_MAX_SIDE}, and its length exactly its fields'. It comes before the first SOS.
 *  - Each SOS: at least one component, each one of the SOF's and none twice (so no more than the SOF has), table
 *    selectors 0 to 3, its length exactly its fields'. A baseline frame has one scan, of the whole band (Ss 0, Se 63,
 *    Ah 0, Al 0); a progressive scan keeps Ss ≤ Se ≤ 63 and Ah, Al ≤ 13, with DC alone in a DC scan and one component
 *    in an AC scan. Every table the scan decodes with is defined before it.
 *  - A scan's entropy data runs to the next marker that is not a stuffed byte or, only after a nonzero DRI, a restart
 *    marker, and holds at least one coded byte.
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

interface Frame {
  width: number;
  height: number;
  progressive: boolean;
  /** each component's id and its quantization table */
  components: { id: number; tq: number }[];
}

function walk(b: Buffer): JpegStill {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) fail();
  let at = 2;
  let frame: Frame | null = null;
  let scans = 0;
  let jfif = false;
  let icc = false;
  let restartInterval = 0;
  const quant = new Set<number>();
  const dc = new Set<number>();
  const ac = new Set<number>();
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
        // one or more 8-bit tables: Pq 0, Tq 0 to 3, then 64 values, filling the segment exactly
        if (body.length === 0) fail();
        for (let i = 0; i < body.length; i += 65) {
          if (body[i]! >> 4 !== 0 || (body[i]! & 0x0f) > 3 || i + 65 > body.length) fail();
          quant.add(body[i]! & 0x0f);
        }
        break;
      case DHT:
        // one or more tables: Tc 0 (DC) or 1 (AC), Th 0 to 3, 16 counts adding to 1..256, then that many values
        if (body.length === 0) fail();
        for (let i = 0; i < body.length; ) {
          if (i + 17 > body.length) fail();
          const tc = body[i]! >> 4;
          const th = body[i]! & 0x0f;
          if (tc > 1 || th > 3) fail();
          let total = 0;
          for (let k = 1; k <= 16; k++) total += body[i + k]!;
          if (total < 1 || total > 256 || i + 17 + total > body.length) fail();
          (tc === 0 ? dc : ac).add(th);
          i += 17 + total;
        }
        break;
      case DRI:
        if (body.length !== 2) fail();
        restartInterval = body.readUInt16BE(0);
        break;
      case SOF0:
      case SOF2: {
        if (frame || body.length < 6) fail();
        const count = body[5]!;
        if (body[0] !== 8 || (count !== 1 && count !== 3) || body.length !== 6 + 3 * count) fail();
        const height = body.readUInt16BE(1);
        const width = body.readUInt16BE(3);
        if (height < 1 || height > POSTER_MAX_SIDE || width < 1 || width > POSTER_MAX_SIDE) fail();
        const components: Frame['components'] = [];
        for (let i = 0; i < count; i++) {
          const id = body[6 + 3 * i]!;
          const h = body[7 + 3 * i]! >> 4;
          const v = body[7 + 3 * i]! & 0x0f;
          const tq = body[8 + 3 * i]!;
          if (components.some((c) => c.id === id) || h < 1 || h > 4 || v < 1 || v > 4 || tq > 3) fail();
          components.push({ id, tq });
        }
        frame = { width, height, components, progressive: marker === SOF2 };
        break;
      }
      case SOS: {
        if (!frame || (!frame.progressive && scans > 0) || body.length < 1) fail();
        const count = body[0]!;
        if (count < 1 || body.length !== 4 + 2 * count) fail();
        const ss = body[1 + 2 * count]!;
        const se = body[2 + 2 * count]!;
        const ah = body[3 + 2 * count]! >> 4;
        const al = body[3 + 2 * count]! & 0x0f;
        if (frame!.progressive) {
          // a DC scan (Ss 0) codes DC alone; an AC scan codes one component's band
          if (ss > se || se > 63 || ah > 13 || al > 13 || (ss === 0 && se !== 0) || (ss > 0 && count !== 1)) fail();
        } else if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) fail();
        const seen: number[] = [];
        for (let i = 0; i < count; i++) {
          const id = body[1 + 2 * i]!;
          const td = body[2 + 2 * i]! >> 4;
          const ta = body[2 + 2 * i]! & 0x0f;
          const component = frame!.components.find((c) => c.id === id);
          if (!component || seen.includes(id) || td > 3 || ta > 3) fail();
          // every table the scan decodes with is defined before it
          if (!quant.has(component!.tq)) fail();
          if (ss === 0 && ah === 0 && !dc.has(td)) fail();
          if (se > 0 && !ac.has(ta)) fail();
          seen.push(id);
        }
        scans++;
        at = entropyEnd(b, end, restartInterval > 0);
        continue;
      }
      default:
        fail();
    }
    at = end;
  }
}

/**
 * Where a scan's entropy data ends: the first 0xFF that is neither a stuffed zero nor, with a restart interval, a
 * restart marker. The scan must hold at least one coded byte; restart markers are not coded data (Codex P2s on #1166).
 */
function entropyEnd(b: Buffer, from: number, restarts: boolean): number {
  let coded = false;
  for (let i = from; i < b.length; i++) {
    if (b[i] !== 0xff) {
      coded = true;
      continue;
    }
    if (i + 1 >= b.length) break;
    const next = b[i + 1]!;
    if (next === 0x00) {
      coded = true;
      i++;
      continue;
    }
    if (next >= 0xd0 && next <= 0xd7) {
      if (!restarts) fail();
      i++;
      continue;
    }
    if (!coded) fail();
    return i;
  }
  return fail();
}
