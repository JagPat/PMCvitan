import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { POSTER_MAX_SIDE, readJpegStill } from './jpeg-still';

const still = (name: string) => readFileSync(join(__dirname, '..', '..', 'test', 'unit-support', 'recordings', name));
const big = still('chromium-153-still-640x360.jpg');
const tiny = still('chromium-153-still-1x1.jpg');

/** A JPEG as its segments: each marker with its body, a scan's entropy data riding after its SOS. */
interface Part { marker: number; body: Buffer; scan?: Buffer }
function parts(b: Buffer): Part[] {
  const out: Part[] = [];
  let at = 2;
  while (b[at + 1] !== 0xd9) {
    const marker = b[at + 1]!;
    const end = at + 2 + b.readUInt16BE(at + 2);
    const part: Part = { marker, body: b.subarray(at + 4, end) };
    at = end;
    if (marker === 0xda) {
      let i = at;
      while (!(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
      part.scan = b.subarray(at, i);
      at = i;
    }
    out.push(part);
  }
  return out;
}
function build(ps: Part[], tail: Buffer = Buffer.from([0xff, 0xd9])): Buffer {
  const chunks = [Buffer.from([0xff, 0xd8])];
  for (const p of ps) {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = p.marker;
    head.writeUInt16BE(p.body.length + 2, 2);
    chunks.push(head, p.body);
    if (p.scan) chunks.push(p.scan);
  }
  chunks.push(tail);
  return Buffer.concat(chunks);
}
const segment = (marker: number, body: number[] | Buffer): Part => ({ marker, body: Buffer.from(body) });
/** The real still, with its parts changed by `edit`. */
const edited = (edit: (ps: Part[]) => Part[]) => build(edit(parts(big).map((p) => ({ ...p, body: Buffer.from(p.body) }))));
const sof = (ps: Part[]) => ps.find((p) => p.marker === 0xc0)!;
const sos = (ps: Part[]) => ps.find((p) => p.marker === 0xda)!;
const before = (ps: Part[], marker: number, add: Part) => {
  const i = ps.findIndex((p) => p.marker === marker);
  return [...ps.slice(0, i), add, ...ps.slice(i)];
};

describe('readJpegStill — real stills', () => {
  it("passes Chromium 153's canvas JPEGs, at their own size", () => {
    expect(readJpegStill(big)).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(tiny)).toEqual({ width: 1, height: 1 });
  });

  it('round-trips the fixture through the test builder unchanged', () => {
    expect(build(parts(big)).equals(big)).toBe(true);
  });
});

describe('readJpegStill — the walk', () => {
  it('refuses a file that is not a JPEG, or is cut short anywhere', () => {
    expect(readJpegStill(Buffer.alloc(0))).toBeNull();
    expect(readJpegStill(Buffer.from('not a jpeg at all'))).toBeNull();
    for (const cut of [2, 3, 20, 600, big.length - 300, big.length - 2, big.length - 1]) {
      expect(readJpegStill(big.subarray(0, cut)), `cut at ${cut}`).toBeNull();
    }
  });

  it('refuses any byte after EOI, and a second EOI', () => {
    expect(readJpegStill(Buffer.concat([big, Buffer.from([0x00])]))).toBeNull();
    expect(readJpegStill(Buffer.concat([big, Buffer.from([0xff, 0xd9])]))).toBeNull();
    expect(readJpegStill(Buffer.concat([big, Buffer.from('<?xml?>')]))).toBeNull();
  });

  it('refuses EOI before any scan, or a frame', () => {
    expect(readJpegStill(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readJpegStill(build(parts(big).filter((p) => p.marker !== 0xda)))).toBeNull();
  });

  it('refuses a segment whose length runs past the file or is under 2', () => {
    const long = Buffer.from(big);
    long.writeUInt16BE(0xffff, 4); // APP0's length
    expect(readJpegStill(long)).toBeNull();
    const short = Buffer.from(big);
    short.writeUInt16BE(1, 4);
    expect(readJpegStill(short)).toBeNull();
  });

  it('refuses a fill byte before a marker', () => {
    const filled = Buffer.concat([big.subarray(0, 2), Buffer.from([0xff]), big.subarray(2)]);
    expect(readJpegStill(filled)).toBeNull();
  });
});

describe('readJpegStill — what may be in it', () => {
  it('refuses Exif or XMP (APP1), every other APPn, and a comment', () => {
    const exif = segment(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0', 'latin1'));
    expect(readJpegStill(edited((ps) => before(ps, 0xdb, exif)))).toBeNull();
    for (const marker of [0xe3, 0xe4, 0xed, 0xee, 0xef, 0xfe]) {
      expect(readJpegStill(edited((ps) => before(ps, 0xdb, segment(marker, [1, 2, 3])))), marker.toString(16)).toBeNull();
    }
  });

  it('refuses arithmetic, lossless, hierarchical and other frames, DNL and the reserved markers', () => {
    for (const marker of [0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xdc, 0xde, 0xdf, 0x01, 0xd0]) {
      expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xc0 ? { ...p, marker } : p)))), marker.toString(16)).toBeNull();
    }
  });

  it('passes without APP0 or the ICC profile, and refuses either twice or after the frame', () => {
    expect(readJpegStill(edited((ps) => ps.filter((p) => p.marker !== 0xe0 && p.marker !== 0xe2)))).toEqual({ width: 640, height: 360 });
    for (const marker of [0xe0, 0xe2]) {
      expect(readJpegStill(edited((ps) => before(ps, 0xdb, ps.find((p) => p.marker === marker)!)))).toBeNull();
      // moved, not copied, so only its place refuses it
      expect(readJpegStill(edited((ps) => before(ps.filter((p) => p.marker !== marker), 0xc4, ps.find((p) => p.marker === marker)!)))).toBeNull();
    }
  });

  it('passes only the 14-byte JFIF header with no thumbnail: a thumbnail, a tail or a short header is refused', () => {
    const app0 = (edit: (body: Buffer) => Buffer) => edited((ps) => ps.map((p) => (p.marker === 0xe0 ? { ...p, body: edit(p.body) } : p)));
    expect(readJpegStill(app0((b) => b))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(app0((b) => Buffer.concat([b.subarray(0, 12), Buffer.from([1, 1, 0, 0, 0])])))).toBeNull(); // a 1 x 1 thumbnail
    expect(readJpegStill(app0((b) => Buffer.concat([b, Buffer.alloc(60)])))).toBeNull();
    expect(readJpegStill(app0((b) => b.subarray(0, 5)))).toBeNull();
    expect(readJpegStill(app0((b) => Buffer.concat([b.subarray(0, 12), Buffer.from([1, 0])])))).toBeNull();
    expect(readJpegStill(app0((b) => Buffer.concat([b.subarray(0, 12), Buffer.from([0, 1])])))).toBeNull();
  });

  it('refuses an APP0 that is not JFIF, and an APP2 that is not one whole ICC profile', () => {
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xe0 ? segment(0xe0, Buffer.from('JFXX\0\x10', 'latin1')) : p))))).toBeNull();
    const icc = (seq: number, count: number) => edited((ps) => ps.map((p) => {
      if (p.marker !== 0xe2) return p;
      p.body[12] = seq;
      p.body[13] = count;
      return p;
    }));
    expect(readJpegStill(icc(1, 1))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(icc(1, 2))).toBeNull();
    expect(readJpegStill(icc(2, 2))).toBeNull();
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xe2 ? segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1')) : p))))).toBeNull();
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xe2 ? segment(0xe2, Buffer.from('MPF\0\x01\x01xx', 'latin1')) : p))))).toBeNull();
  });

  it('refuses an empty DQT or DHT, and a DRI that is not 4 bytes; passes one that is', () => {
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xdb ? segment(0xdb, []) : p))))).toBeNull();
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xc4 ? segment(0xc4, []) : p))))).toBeNull();
    expect(readJpegStill(edited((ps) => before(ps, 0xda, segment(0xdd, [0, 0]))))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(edited((ps) => before(ps, 0xda, segment(0xdd, [0, 0, 0]))))).toBeNull();
  });
});

describe('readJpegStill — the frame', () => {
  const frame = (edit: (body: Buffer) => Buffer | void) => edited((ps) => {
    const p = sof(ps);
    p.body = edit(p.body) ?? p.body;
    return ps;
  });

  it('reads the size from the frame, and refuses 0 or more than the cap on either side', () => {
    const sized = (w: number, h: number) => frame((b) => {
      b.writeUInt16BE(h, 1);
      b.writeUInt16BE(w, 3);
    });
    expect(readJpegStill(sized(POSTER_MAX_SIDE, POSTER_MAX_SIDE))).toEqual({ width: POSTER_MAX_SIDE, height: POSTER_MAX_SIDE });
    expect(readJpegStill(sized(1, 1))).toEqual({ width: 1, height: 1 });
    for (const [w, h] of [[0, 360], [640, 0], [POSTER_MAX_SIDE + 1, 360], [640, POSTER_MAX_SIDE + 1], [65535, 65535]] as const) {
      expect(readJpegStill(sized(w, h)), `${w}x${h}`).toBeNull();
    }
  });

  it('refuses a precision other than 8', () => {
    expect(readJpegStill(frame((b) => void (b[0] = 12)))).toBeNull();
  });

  it('refuses 2 or 4 components, and a length that is not its fields', () => {
    expect(readJpegStill(frame((b) => Buffer.concat([b.subarray(0, 5), Buffer.from([2]), b.subarray(6, 12)])))).toBeNull();
    expect(readJpegStill(frame((b) => Buffer.concat([b.subarray(0, 5), Buffer.from([4]), b.subarray(6), Buffer.from([4, 0x11, 0])])))).toBeNull();
    expect(readJpegStill(frame((b) => Buffer.concat([b, Buffer.from([0])])))).toBeNull();
    expect(readJpegStill(frame((b) => b.subarray(0, 14)))).toBeNull();
  });

  it('refuses a repeated component id, a sampling factor of 0 or over 4, and a table over 3', () => {
    // the scan names only ids the frame has, so only the frame's repeat refuses it
    expect(readJpegStill(edited((ps) => {
      const f = sof(ps).body;
      f[9] = f[6]!;
      sos(ps).body = Buffer.from([2, f[6]!, 0, f[12]!, 0x11, 0, 63, 0]);
      return ps;
    }))).toBeNull();
    for (const sampling of [0x01, 0x10, 0x51, 0x15]) expect(readJpegStill(frame((b) => void (b[7] = sampling))), sampling.toString(16)).toBeNull();
    expect(readJpegStill(frame((b) => void (b[8] = 4)))).toBeNull();
  });

  it('refuses a second frame', () => {
    expect(readJpegStill(edited((ps) => before(ps, 0xda, sof(ps))))).toBeNull();
  });

  it('passes a progressive frame with several scans, and refuses a second scan on a baseline frame', () => {
    const two = (marker: number) => edited((ps) => {
      sof(ps).marker = marker;
      const scan = sos(ps);
      return [...ps, { ...scan }];
    });
    expect(readJpegStill(two(0xc2))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(two(0xc0))).toBeNull();
  });
});

describe('readJpegStill — the scan', () => {
  const scan = (edit: (p: Part) => void) => edited((ps) => {
    edit(sos(ps));
    return ps;
  });

  it('refuses a scan before the frame', () => {
    expect(readJpegStill(edited((ps) => before(ps, 0xc0, sos(ps))))).toBeNull();
  });

  it('refuses no components, more than the frame has, one the frame does not name, or one named twice', () => {
    const header = (count: number, ids: number[]) => scan((p) => {
      p.body = Buffer.from([count, ...ids.flatMap((id) => [id, 0]), 0, 63, 0]);
    });
    const ids = [sof(parts(big)).body[6]!, sof(parts(big)).body[9]!, sof(parts(big)).body[12]!];
    expect(readJpegStill(header(3, ids))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(header(0, []))).toBeNull();
    expect(readJpegStill(header(4, [...ids, 9]))).toBeNull();
    expect(readJpegStill(header(1, [9]))).toBeNull();
    expect(readJpegStill(header(2, [ids[0]!, ids[0]!]))).toBeNull();
  });

  it('refuses a scan header whose length is not its fields', () => {
    expect(readJpegStill(scan((p) => void (p.body = Buffer.concat([p.body, Buffer.from([0])]))))).toBeNull();
    expect(readJpegStill(scan((p) => void (p.body = p.body.subarray(0, p.body.length - 1))))).toBeNull();
  });

  it('reads stuffed bytes and restart markers as entropy data, and refuses a scan that never reaches a marker', () => {
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.concat([p.scan!, Buffer.from([0xff, 0x00, 0xff, 0xd0, 0x12])]))))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(Buffer.concat([build(parts(big), Buffer.alloc(0)), Buffer.from([0x12, 0xff])]))).toBeNull();
  });

  it('refuses a scan with no coded data (Codex P2 on #1166)', () => {
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.alloc(0))))).toBeNull();
    const two = edited((ps) => {
      sof(ps).marker = 0xc2;
      return [...ps, { ...sos(ps), scan: Buffer.alloc(0) }];
    });
    expect(readJpegStill(two)).toBeNull();
  });

  it('refuses a marker the walk does not name inside the entropy data', () => {
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.concat([p.scan!, Buffer.from([0xff, 0xfe, 0, 4, 1, 2])]))))).toBeNull();
  });
});
